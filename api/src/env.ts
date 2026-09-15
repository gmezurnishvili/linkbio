export const env = {
  tableName: process.env.TABLE_NAME ?? 'linkbio',
  region: process.env.AWS_REGION ?? 'us-east-1',
  kvsArn: process.env.KVS_ARN ?? '',
  jwksUrl: process.env.JWKS_URL ?? '',
  jwtIssuer: process.env.JWT_ISSUER ?? '',
  jwtAudience: process.env.JWT_AUDIENCE ?? '',
  devSecret: process.env.DEV_JWT_SECRET ?? '',
  driver: (process.env.DB_DRIVER ?? 'dynamo') as 'dynamo' | 'memory',
  maxBlocks: Number(process.env.MAX_BLOCKS ?? 200),
  maxRules: Number(process.env.MAX_RULES ?? 20),
};
