import { Stack, RemovalPolicy, Duration, CfnOutput, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export class LinkbioStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- data ----------

    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
        },
        {
          // Sparse on purpose: only feed blocks carry GSI2PK, so the index holds
          // refreshable blocks and nothing else.
          indexName: 'GSI2',
          partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.NUMBER },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
    });

    // ---------- edge config ----------

    const kvs = new cloudfront.KeyValueStore(this, 'RoutingConfig', {
      comment: 'Per-handle cache-key masks and hot links',
    });

    const normalizer = new cloudfront.Function(this, 'CtxNormalizer', {
      runtime: cloudfront.FunctionRuntime.JS_2_0, // required for KeyValueStore access
      keyValueStore: kvs,
      code: cloudfront.FunctionCode.fromFile({ filePath: 'edge/normalize.js' }),
    });

    // ---------- api ----------

    const api = new lambda.Function(this, 'Api', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, // ~20% cheaper per GB-second
      handler: 'index.handler',
      code: lambda.Code.fromAsset('dist'),
      memorySize: 1024,
      timeout: Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        KVS_ARN: kvs.keyValueStoreArn,
        NODE_OPTIONS: '--enable-source-maps',
      },
      // Deliberately not in a VPC. DynamoDB and CloudFront are reached over the
      // public AWS endpoints, so attaching one would only add a NAT gateway at
      // ~$33/month before a single request is served.
    });

    table.grantReadWriteData(api);
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
        'cloudfront-keyvaluestore:PutKey',
        'cloudfront-keyvaluestore:DeleteKey',
      ],
      resources: [kvs.keyValueStoreArn],
    }));

    const fnUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // ---------- distribution ----------

    // x-ctx is the only header in the cache key. Everything the origin varies on
    // is folded into it by the edge function, which keeps cardinality bounded.
    const redirectCache = new cloudfront.CachePolicy(this, 'RedirectCache', {
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('x-ctx'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: Duration.seconds(60),
      minTtl: Duration.seconds(0),
      // Must exceed the API's MAX_S_MAXAGE or CloudFront silently truncates
      // every TTL the rule evaluator computes.
      maxTtl: Duration.hours(24),
      enableAcceptEncodingGzip: true,
    });

    // The origin still needs the raw viewer signals to compute the right answer
    // even though they are not part of the cache key.
    const originRequest = new cloudfront.OriginRequestPolicy(this, 'OriginRequest', {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        'x-ctx', 'cloudfront-viewer-country', 'cloudfront-is-mobile-viewer',
        'cloudfront-is-tablet-viewer', 'user-agent', 'referer', 'accept-language',
      ),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    const origin = origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl, {
      readTimeout: Duration.seconds(10),
    });

    const behavior = {
      origin,
      cachePolicy: redirectCache,
      originRequestPolicy: originRequest,
      functionAssociations: [{
        function: normalizer,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      }],
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    };

    const dist = new cloudfront.Distribution(this, 'Cdn', {
      defaultBehavior: behavior,
      additionalBehaviors: {
        '/r/*': behavior,
        '/p/*': behavior,
        // The control plane is per-user and must never be cached.
        '/v1/*': {
          origin,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        },
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      // Collapses the synchronised cache-miss stampede that happens when every
      // edge location's TTL expires at the same rule boundary.
      enableLogging: true,
    });

    new CfnOutput(this, 'DistributionDomain', { value: dist.distributionDomainName });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'KvsArn', { value: kvs.keyValueStoreArn });
  }
}
