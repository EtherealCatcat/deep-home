import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireProviderCall,
  noteProviderFailure,
  noteProviderProbe,
  providerAllowsEssential,
  providerAllowsNonEssential,
  providerSnapshot,
  releaseProviderCall,
  resetProviderHealth,
} from "../src/provider.js";

const T0 = new Date("2026-11-18T13:00:00+08:00").getTime();

function failure(kind: "network" | "timeout" | "auth" | "rate" | "server" | "config" | "unknown", extra: { retryAfterMs?: number; status?: number } = {}) {
  return {
    kind,
    message: "失败了",
    at: Date.now(),
    attempts: 1,
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetProviderHealth();
});

afterEach(() => {
  vi.useRealTimers();
  resetProviderHealth();
});

describe("provider circuit", () => {
  it("opens after three infrastructure failures and allows one half-open attempt", () => {
    for (let index = 0; index < 2; index += 1) {
      noteProviderFailure(failure("server", { status: 503 }));
    }
    expect(providerSnapshot().state).toBe("ok");
    noteProviderFailure(failure("server", { status: 503 }));
    expect(providerSnapshot().state).toBe("down");
    expect(providerSnapshot().consecutiveFailures).toBe(3);
    expect(providerSnapshot().openUntil).toBe(T0 + 60_000);

    const blocked = acquireProviderCall();
    expect(blocked.ok).toBe(false);
    expect(providerAllowsEssential(T0)).toBe(false);
    expect(providerAllowsNonEssential()).toBe(false);

    vi.setSystemTime(T0 + 60_001);
    const halfOpen = acquireProviderCall();
    expect(halfOpen.ok).toBe(true);
    expect(halfOpen.halfOpen).toBe(true);
    expect(acquireProviderCall().ok).toBe(false);

    releaseProviderCall(halfOpen);
    expect(providerSnapshot().state).toBe("ok");
    expect(providerSnapshot().consecutiveFailures).toBe(0);
  });

  it("locks on auth and config failures", () => {
    noteProviderFailure(failure("auth", { status: 401 }));
    expect(providerSnapshot().state).toBe("auth");
    expect(acquireProviderCall().ok).toBe(false);
    expect(acquireProviderCall(true).ok).toBe(true);

    resetProviderHealth();
    noteProviderFailure(failure("config", { status: 404 }));
    expect(providerSnapshot().state).toBe("config");
    expect(acquireProviderCall().ok).toBe(false);
    expect(providerAllowsEssential(T0)).toBe(false);
  });

  it("honours rate limits until retryAt", () => {
    noteProviderFailure(failure("rate", { status: 429, retryAfterMs: 120_000 }));
    expect(providerSnapshot().state).toBe("rate");
    expect(providerSnapshot().retryAt).toBe(T0 + 120_000);
    expect(acquireProviderCall().ok).toBe(false);
    expect(providerAllowsEssential(T0 + 119_999)).toBe(false);

    vi.setSystemTime(T0 + 120_001);
    expect(providerAllowsEssential(Date.now())).toBe(true);
    const ticket = acquireProviderCall();
    expect(ticket.ok).toBe(true);
    expect(providerSnapshot().state).toBe("ok");
  });

  it("recovers a down circuit only after a successful probe", () => {
    for (let index = 0; index < 3; index += 1) noteProviderFailure(failure("network"));
    vi.setSystemTime(T0 + 60_001);
    noteProviderProbe(false, 503);
    expect(providerSnapshot().state).toBe("down");
    expect(providerSnapshot().lastProbeOk).toBe(false);

    vi.setSystemTime(T0 + 120_002);
    noteProviderProbe(true, 200);
    expect(providerSnapshot().state).toBe("ok");
    expect(providerSnapshot().consecutiveFailures).toBe(0);
  });

  it("resets on demand", () => {
    noteProviderFailure(failure("auth", { status: 401 }));
    resetProviderHealth();
    expect(providerSnapshot().state).toBe("ok");
    expect(providerSnapshot().consecutiveFailures).toBe(0);
  });
});
