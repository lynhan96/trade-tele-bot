import { HttpsProxyAgent } from "https-proxy-agent";

const PROXIES = [
  "http://9SM6Of:YhAvBfsm@snvn1.tunproxy.com:21992",
  "http://9SM6Of:YhAvBfsm@snvn7.tunproxy.com:15947",
  "http://9SM6Of:YhAvBfsm@snvn2.tunproxy.com:23441",
  "http://9SM6Of:YhAvBfsm@snvn9.tunproxy.com:13740",
  "http://9SM6Of:YhAvBfsm@snvn3.tunproxy.com:19224",
  "http://9SM6Of:YhAvBfsm@snf3.tunproxy.com:13679",
  "http://9SM6Of:YhAvBfsm@snvt2.tunproxy.com:25517",
  "http://9SM6Of:YhAvBfsm@snvt9.tunproxy.com:16179",
  "http://9SM6Of:YhAvBfsm@snf3.tunproxy.com:15064",
  "http://9SM6Of:YhAvBfsm@snvn4.tunproxy.com:13176",
];

let index = 0;

/** Round-robin proxy agent for Binance public market data HTTP calls. */
export function getProxyAgent(): HttpsProxyAgent<string> {
  const proxy = PROXIES[index % PROXIES.length];
  index++;
  return new HttpsProxyAgent(proxy);
}
