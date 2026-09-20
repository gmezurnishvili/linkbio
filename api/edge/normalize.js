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

  // Anything the viewer sent under this name is discarded before we look at the
  // path. Every early return below would otherwise forward it to the origin,
  // which trusts x-ctx as the normalized context it computed here.
  delete req.headers['x-ctx'];

  var parts = req.uri.split('/');
  if (parts.length < 3) return req;

  var handle = parts[2];
  if (!handle) return req;
  var slug = parts[3] || '';

  // A hot link is a destination the origin would compute the same way for
  // everyone, forever: no rules, no activity window, on a published page. The
  // API writes those to the store on publish and deletes them the moment any of
  // that stops being true, so an entry existing here *is* the guarantee that no
  // evaluation is needed.
  //
  // `<status>|<url>`, split on the first separator only. A URL may legally
  // contain `|` in its query, and splitting on every one of them truncated the
  // destination to everything before it.
  if (slug) {
    try {
      var hot = await kvs.get('hot:' + handle + '/' + slug, { format: 'string' });
      if (hot) {
        var bar = hot.indexOf('|');
        var status = parseInt(hot.substring(0, bar), 10);
        var location = hot.substring(bar + 1);
        if (location && (status === 302 || status === 307)) {
          return {
            statusCode: status,
            statusDescription: status === 307 ? 'Temporary Redirect' : 'Found',
            headers: { location: { value: location } },
          };
        }
      }
    } catch (e) {}
  }

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

  // Five fixed slots, always, in `gdrlw` order, with '-' for any dimension this
  // profile's rules do not read.
  //
  // Emitting only the masked dimensions is what the first version did, and it
  // was wrong: the origin decodes by position, so a mask of 'd' put the device
  // token in the geo slot and the rule never matched — while the answer was
  // still returned as cacheable and replayed to everyone sharing the key. Fixed
  // slots cost four bytes and make the encoding self-describing.
  //
  // Cardinality is unaffected: an unmasked slot is the constant '-', so a
  // profile with no rules has exactly one cache key per path.
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

  // Written unconditionally, including for maskless profiles. x-ctx is the sole
  // header in the cache policy, so leaving a viewer-supplied one in place hands
  // any client an unbounded supply of cache keys and an on-demand origin hit.
  req.headers['x-ctx'] = {
    value: 'v' + version + '|' + geo + '.' + device + '.' + referrer + '.' + lang + '.' + webview,
  };
  return req;
}
