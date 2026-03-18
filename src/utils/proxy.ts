import { HttpsProxyAgent } from "https-proxy-agent";

const PROXIES = [
  "http://4L9CkL:MKpLcE3q@snvn9.tunproxy.com:12225",
  "http://4L9CkL:MKpLcE3q@snf1.tunproxy.com:17933",
  "http://4L9CkL:MKpLcE3q@snvt8.tunproxy.com:19170",
  "http://4L9CkL:MKpLcE3q@snvt7.tunproxy.com:34293",
  "http://4L9CkL:MKpLcE3q@snvn10.tunproxy.com:21323",
  "http://4L9CkL:MKpLcE3q@snvn5.tunproxy.com:11266",
  "http://4L9CkL:MKpLcE3q@snf6.tunproxy.com:27006",
  "http://4L9CkL:MKpLcE3q@snvn3.tunproxy.com:31960",
  "http://4L9CkL:MKpLcE3q@snvt4.tunproxy.com:22116",
  "http://4L9CkL:MKpLcE3q@snvt6.tunproxy.com:15433",
  "http://4L9CkL:MKpLcE3q@snf2.tunproxy.com:11186",
  "http://4L9CkL:MKpLcE3q@snf3.tunproxy.com:18318",
  "http://4L9CkL:MKpLcE3q@snvt6.tunproxy.com:30319",
  "http://4L9CkL:MKpLcE3q@snvn11.tunproxy.com:22380",
  "http://4L9CkL:MKpLcE3q@snf1.tunproxy.com:16601",
  "http://4L9CkL:MKpLcE3q@snvt1.tunproxy.com:23896",
  "http://4L9CkL:MKpLcE3q@snvt10.tunproxy.com:28436",
  "http://4L9CkL:MKpLcE3q@snvn8.tunproxy.com:21325",
  "http://4L9CkL:MKpLcE3q@snvn2.tunproxy.com:19251",
  "http://4L9CkL:MKpLcE3q@snf3.tunproxy.com:24616",
];

let index = 0;

/** Round-robin proxy agent for Binance public market data HTTP calls. */
export function getProxyAgent(): HttpsProxyAgent<string> {
  const proxy = PROXIES[index % PROXIES.length];
  index++;
  return new HttpsProxyAgent(proxy);
}
