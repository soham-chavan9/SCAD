import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOUCH_DEBOUNCE_MS, WakeCoordinator, type MachineClient } from "./wake.js";

const APP = "11111111-1111-4111-8111-111111111111";
const ALICE = "22222222-2222-4222-8222-222222222222";
const BOB = "33333333-3333-4333-8333-333333333333";

describe("WakeCoordinator.touch debounce keeps usage accounting (§9 step 8)", () => {
  let calls: { appId: string; userId: string; requests: number }[];
  let coordinator: WakeCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    const client: MachineClient = {
      wake: async () => undefined,
      touch: async (appId, userId, requests) => {
        calls.push({ appId, userId, requests });
      },
    };
    coordinator = new WakeCoordinator({ client });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a touch for each distinct viewer inside one window", () => {
    coordinator.touch(APP, ALICE);
    coordinator.touch(APP, BOB);
    expect(calls).toEqual([
      { appId: APP, userId: ALICE, requests: 1 },
      { appId: APP, userId: BOB, requests: 1 },
    ]);
  });

  it("counts debounced requests and sends them when the window closes", () => {
    for (let i = 0; i < 5; i++) coordinator.touch(APP, ALICE);
    expect(calls).toEqual([{ appId: APP, userId: ALICE, requests: 1 }]);
    vi.advanceTimersByTime(TOUCH_DEBOUNCE_MS);
    expect(calls).toEqual([
      { appId: APP, userId: ALICE, requests: 1 },
      { appId: APP, userId: ALICE, requests: 4 },
    ]);
  });

  it("sends nothing extra when a window had a single request", () => {
    coordinator.touch(APP, ALICE);
    vi.advanceTimersByTime(TOUCH_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    coordinator.touch(APP, ALICE);
    expect(calls).toHaveLength(2);
  });
});
