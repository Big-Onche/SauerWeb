import { describe, expect, it, vi } from "vitest";
import { AiType } from "./ai";
import { AiManager, type AiServerClient } from "./aiman";

function human(clientNumber: number): AiServerClient {
  return { clientNumber, ownerNumber: -1, aiType: AiType.None, skill: 0, model: 0, name: `human${clientNumber}`, team: "",
    spectator: false, local: true, privilege: 0, warned: false, alive: true, connected: true, bots: [], aiReinit: 0 };
}

describe("AiManager", () => {
  it("assigns bots to the least-loaded eligible native client", () => {
    const initAi = vi.fn(), manager = new AiManager({ initAi, disconnectAi: vi.fn(), setTeam: vi.fn(), resumeAi: vi.fn() }, () => 0);
    const first = human(0), second = human(1);
    manager.addClient(first);
    manager.addClient(second);
    expect(manager.addai(80)).toBe(true);
    expect(manager.addai(90)).toBe(true);
    manager.checkai();
    expect(first.bots).toHaveLength(1);
    expect(second.bots).toHaveLength(1);
    expect(initAi).toHaveBeenCalledTimes(2);
  });

  it("enforces the native privilege gate for remote add requests", () => {
    const manager = new AiManager({ initAi: vi.fn(), disconnectAi: vi.fn(), setTeam: vi.fn(), resumeAi: vi.fn() });
    const requester = { ...human(0), local: false };
    manager.addClient(requester);
    expect(manager.reqadd(requester, 50)).toBe(false);
    requester.privilege = 1;
    expect(manager.reqadd(requester, 50)).toBe(true);
  });
});
