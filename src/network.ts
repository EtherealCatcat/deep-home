import os from "node:os";

/**
 * 本机有没有可用的网络出口。
 *
 * 只看 IPv4：真正的断网、飞行模式、网线拔掉时，所有网卡都会消失或只剩
 * internal / 169.254 链路本地地址。虚拟网卡（代理、VPN）只要拿到地址也算有网，
 * 因为它们恰恰说明用户还在线，只是请求要走代理。
 */
export function localNetworkAvailable(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): boolean {
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.internal) continue;
      if (info.family !== "IPv4") continue;
      const address = info.address;
      if (!address || address === "0.0.0.0") continue;
      if (address.startsWith("169.254.")) continue;
      return true;
    }
  }
  return false;
}
