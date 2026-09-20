import cf from 'cloudfront';

const kvs = cf.kvs();

/**
 * Viewer-request function for the web origin.
 *
 * `edge/normalize.js` does this for `/r/<handle>/<blockId>` and `/p/<handle>`,
 * which are API paths. The public profile page is `/<handle>` at the root, on
 * the Next origin, and it needs the same treatment for the same reason: the
 * page's content depends on the viewer, so the cache key has to as well, and
 * `x-ctx` is the only header in that key.
 *
 * Two differences from the API's function, both deliberate:
 *
 *   - no hot-link short-circuit. A root path is a page, not a click, and there
 *     is nothing to answer from the store.
 *   - it copies the viewer's Host into `x-forwarded-host`. CloudFront sends a
 *     Lambda function URL origin its *own* hostname, because Origin Access
 *     Control signs against that host, so the origin otherwise has no way to
 *     know what domain the visitor typed — and the page puts that domain in its
 *     canonical URL and its JSON-LD `@id`. The alternative, handing the Lambda
 *     the distribution's own domain as an environment variable, is a
 *     CloudFormation cycle: the distribution already names the Lambda.
 *
 * Kept in `api/edge/` next to the others because `cdk.json` runs from `api/`
 * and `FunctionCode.fromFile` resolves against that directory.
 */

const GEO = {
  US: 'na', CA: 'na',
  MX: 'latam', BR: 'latam', AR: 'latam', CL: 'latam', CO: 'latam',
  GB: 'eu', IE: 'eu', DE: 'eu', FR: 'eu', ES: 'eu', IT: 'eu', NL: 'eu', PL: 'eu', SE: 'eu',
  JP: 'apac', KR: 'apac', CN: 'apac', IN: 'apac', AU: 'apac', NZ: 'apac', SG: 'apac', ID: 'apac',
  AE: 'mea', SA: 'mea', ZA: 'mea', NG: 'mea', EG: 'mea', IL: 'mea', TR: 'mea',
};

var WEBVIEW = /Instagram|FBAV|FBAN|FB_IAB|TikTok|Line\/|MicroMessenger|Snapchat|Pinterest/;

/**
 * Paths under the root that belong to the product rather than to a creator.
 *
 * This is the same list as `RESERVED_HANDLES` in `web/src/lib/handles.ts`,
 * minus the ones that already have their own cache behaviour. A path that is
 * not a handle has no mask to look up, so skipping the store read here is one
 * fewer KeyValueStore call on every dashboard navigation.
 */
var NOT_A_HANDLE = {
  api: 1, admin: 1, www: 1, app: 1, login: 1, logout: 1, signup: 1, settings: 1,
  support: 1, help: 1, about: 1, terms: 1, privacy: 1, static: 1, assets: 1,
  r: 1, p: 1, v1: 1, health: 1, pricing: 1, status: 1, _next: 1,
  'favicon.ico': 1, 'robots.txt': 1, 'sitemap.xml': 1, 'icon.svg': 1,
};

function refClass(ref) {
  if (!ref) return 'dir';
  var m = ref.match(/^https?:\/\/([^/?#]+)/);
  if (!m) return 'oth';
  var h = m[1].toLowerCase();
  if (h.indexOf('instagram') >= 0) return 'ig';
  if (h.indexOf('tiktok') >= 0) return 'tt';
  if (h.indexOf('linkedin') >= 0 || h === 'lnkd.in') return 'li';
  if (h.indexOf('youtube') >= 0 || h === 'youtu.be') return 'yt';
  if (h.indexOf('twitter') >= 0 || h === 't.co' || h.indexOf('x.com') >= 0) return 'x';
  if (h.indexOf('facebook') >= 0 || h === 'fb.me') return 'fb';
  return 'oth';
}

async function handler(event) {
  var req = event.request;
  var h = req.headers;

  // Both of these are ours to write. Anything a viewer sent under either name
  // is discarded before the first early return, or it would be forwarded to an
  // origin that trusts them.
  delete req.headers['x-ctx'];
  delete req.headers['x-forwarded-host'];

  if (event.context && event.context.distributionDomainName) {
    // The Host the viewer used, which for a custom domain is the custom domain.
    var viewerHost = h.host && h.host.value ? h.host.value : event.context.distributionDomainName;
    req.headers['x-forwarded-host'] = { value: viewerHost };
  } else if (h.host && h.host.value) {
    req.headers['x-forwarded-host'] = { value: h.host.value };
  }

  var parts = req.uri.split('/');
  // Exactly one segment: `/giorgi`. Anything deeper on this origin is a
  // dashboard route or an asset, and neither varies by viewer.
  if (parts.length !== 2) return req;

  var handle = parts[1];
  if (!handle || NOT_A_HANDLE[handle]) return req;

  var mask = '';
  var version = '0';
  try {
    var raw = await kvs.get('mask:' + handle.toLowerCase(), { format: 'string' });
    if (raw) {
      var i = raw.indexOf('|');
      version = raw.substring(1, i);
      mask = raw.substring(i + 1);
    }
  } catch (e) {}

  // Five fixed slots, always, in `gdrlw` order, with '-' for any dimension this
  // profile's rules do not read. Positional by design — see the long comment in
  // `normalize.js`; emitting only the masked dimensions put the device token in
  // the geo slot and cached the resulting wrong answer.
  var geo = '-';
  var device = '-';
  var referrer = '-';
  var lang = '-';
  var webview = '-';

  if (mask.indexOf('g') >= 0) {
    var c = h['cloudfront-viewer-country'] ? h['cloudfront-viewer-country'].value : '';
    geo = GEO[c] || 'xx';
  }
  if (mask.indexOf('d') >= 0) {
    var isTablet = h['cloudfront-is-tablet-viewer'] && h['cloudfront-is-tablet-viewer'].value === 'true';
    var isMobile = h['cloudfront-is-mobile-viewer'] && h['cloudfront-is-mobile-viewer'].value === 'true';
    device = isTablet ? 't' : isMobile ? 'm' : 'd';
  }
  if (mask.indexOf('r') >= 0) referrer = refClass(h.referer ? h.referer.value : '');
  if (mask.indexOf('l') >= 0) {
    lang = (h['accept-language'] ? h['accept-language'].value : 'en').substring(0, 2).toLowerCase();
  }
  if (mask.indexOf('w') >= 0) {
    webview = WEBVIEW.test(h['user-agent'] ? h['user-agent'].value : '') ? '1' : '0';
  }

  // Written unconditionally, including for maskless profiles: x-ctx is the sole
  // header in the cache policy, so an absent one would let a viewer-supplied
  // value decide the key.
  req.headers['x-ctx'] = {
    value: 'v' + version + '|' + geo + '.' + device + '.' + referrer + '.' + lang + '.' + webview,
  };
  return req;
}
