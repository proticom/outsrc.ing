import { spawn } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { captureProcess, sameProcess, stopOwnedProcess } from "../src/job.ts";

const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

function sleeper(): number {
  const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error("sleep failed to start");
  leftovers.push(child.pid);
  return child.pid;
}

describe("process identity", () => {
  test("a start time recorded under one locale and time zone still matches under another", () => {
    const pid = sleeper();
    const saved = { LANG: process.env.LANG, TZ: process.env.TZ };
    try {
      Object.assign(process.env, { LANG: "de_DE.UTF-8", TZ: "Asia/Tokyo" });
      const recorded = captureProcess(pid);
      Object.assign(process.env, { LANG: "en_US.UTF-8", TZ: "America/Los_Angeles" });
      expect(recorded && sameProcess(recorded)).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

describe("process signals", () => {
  test("does not signal process group 1 or a process with a different start time", () => {
    const kill = vi.spyOn(process, "kill");
    expect(stopOwnedProcess({ pid: 1, pgid: 1, startedAt: "launchd" })).toBe(false);
    expect(stopOwnedProcess({ pid: 40, pgid: 1, startedAt: "launchd" })).toBe(false);
    const pid = sleeper();
    const recorded = captureProcess(pid);
    if (!recorded) throw new Error("sleep start time was not recorded");
    expect(stopOwnedProcess({ ...recorded, startedAt: "not-this-process" })).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(kill.mock.calls.filter(([value]) => typeof value === "number" && value < 0)).toEqual([]);
    kill.mockRestore();
  });

  test("signals the recorded sleep process", async () => {
    const pid = sleeper();
    const recorded = captureProcess(pid);
    if (!recorded) throw new Error("sleep start time was not recorded");
    expect(sameProcess(recorded)).toBe(true);
    expect(stopOwnedProcess(recorded)).toBe(true);
    await expect.poll(() => {
      try { process.kill(pid, 0); return "alive"; }
      catch { return "dead"; }
    }).toBe("dead");
  });
});
