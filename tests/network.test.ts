import { describe, expect, it } from "vitest";
import os from "node:os";
import { localNetworkAvailable } from "../src/network.js";

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function single(address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false): Interfaces {
  return {
    en0: [
      {
        address,
        netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
        family,
        mac: "00:00:00:00:00:00",
        internal,
        cidr: family === "IPv4" ? `${address}/24` : `${address}/64`,
        scopeid: 0,
      },
    ],
  };
}

describe("localNetworkAvailable", () => {
  it("accepts a non-internal IPv4 address", () => {
    expect(localNetworkAvailable(single("192.168.1.5"))).toBe(true);
  });

  it("rejects loopback-only machines", () => {
    expect(localNetworkAvailable(single("127.0.0.1", "IPv4", true))).toBe(false);
  });

  it("ignores self-assigned and unspecified addresses", () => {
    expect(localNetworkAvailable(single("169.254.10.2"))).toBe(false);
    expect(localNetworkAvailable(single("0.0.0.0"))).toBe(false);
  });

  it("rejects machines that only have IPv6", () => {
    expect(localNetworkAvailable(single("fe80::1", "IPv6"))).toBe(false);
  });

  it("finds a usable address among several interfaces", () => {
    const interfaces: Interfaces = {
      lo0: single("127.0.0.1", "IPv4", true).en0,
      en0: single("10.0.0.9").en0,
    };
    expect(localNetworkAvailable(interfaces)).toBe(true);
  });
});
