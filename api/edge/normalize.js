import cf from 'cloudfront';

const kvs = cf.kvs();

const GEO = {
  US: 'na', CA: 'na',
  MX: 'latam', BR: 'latam', AR: 'latam', CL: 'latam', CO: 'latam',
  GB: 'eu', IE: 'eu', DE: 'eu', FR: 'eu', ES: 'eu', IT: 'eu', NL: 'eu', PL: 'eu', SE: 'eu',
  JP: 'apac', KR: 'apac', CN: 'apac', IN: 'apac', AU: 'apac', NZ: 'apac', SG: 'apac', ID: 'apac',
  AE: 'mea', SA: 'mea', ZA: 'mea', NG: 'mea', EG: 'mea', IL: 'mea', TR: 'mea',
};

var WEBVIEW = /Instagram|FBAV|FBAN|FB_IAB|TikTok|Line\/|MicroMessenger|Snapchat|Pinterest/;

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

/**
 * Viewer-request function.
 *
 * Two KeyValueStore reads at most. The first short-circuits fully static links
 * without ever touching the origin; the second decides which viewer signals get
 * folded into the cache key. A handle with no mask entry caches on path alone,
 * which is the overwhelming majority of traffic and the cheapest possible path.
 */
async function handler(event) {
  var req = event.request;
  var h = req.headers;
  var parts = req.uri.split('/');
  if (parts.length < 3) return req;

  var handle = parts[2];
  if (!handle) return req;
  var slug = parts[3] || '';

  try {
    var hot = await kvs.get('hot:' + handle + '/' + slug, { format: 'string' });
    if (hot) {
      var bits = hot.split('|');
      return {
        statusCode: parseInt(bits[1], 10) || 302,
        statusDescription: 'Found',
        headers: { location: { value: bits[0] } },
      };
    }
  } catch (e) {}

  var mask = '';
  var version = '0';
  try {
    var raw = await kvs.get('mask:' + handle, { format: 'string' });
    if (raw) {
      var i = raw.indexOf('|');
      version = raw.substring(1, i);
      mask = raw.substring(i + 1);
    }
  } catch (e) {}

  if (!mask) return req;

  var out = [];
  if (mask.indexOf('g') >= 0) {
    var c = h['cloudfront-viewer-country'] ? h['cloudfront-viewer-country'].value : '';
    out.push(GEO[c] || 'xx');
  }
  if (mask.indexOf('d') >= 0) {
    var isTablet = h['cloudfront-is-tablet-viewer'] && h['cloudfront-is-tablet-viewer'].value === 'true';
    var isMobile = h['cloudfront-is-mobile-viewer'] && h['cloudfront-is-mobile-viewer'].value === 'true';
    out.push(isTablet ? 't' : isMobile ? 'm' : 'd');
  }
  if (mask.indexOf('r') >= 0) out.push(refClass(h.referer ? h.referer.value : ''));
  if (mask.indexOf('l') >= 0) {
    out.push((h['accept-language'] ? h['accept-language'].value : 'en').substring(0, 2).toLowerCase());
  }
  if (mask.indexOf('w') >= 0) {
    out.push(WEBVIEW.test(h['user-agent'] ? h['user-agent'].value : '') ? '1' : '0');
  }

  req.headers['x-ctx'] = { value: 'v' + version + '|' + out.join('.') };
  return req;
}
