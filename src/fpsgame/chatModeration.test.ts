import { describe, expect, it } from "vitest";
import { ChatModeration, containsBannedChatWord, normalizeChatWord } from "./chatModeration";

describe("chat moderation", () => {
  it("accepts and trims ordinary chat", () => {
    const moderation = new ChatModeration({ bannedWords: ["hitler"] });
    expect(moderation.validate("  good game  ", "server-a")).toEqual({ accepted: true, message: "good game" });
  });

  it("rejects empty messages", () => {
    const moderation = new ChatModeration();
    expect(moderation.validate(" \n\t ", "server-a")).toMatchObject({
      accepted: false, reason: "empty", feedback: "Message not sent: empty message.",
    });
  });

  it("shares the rolling limit between public and team chat for one player", () => {
    let now = 1_000;
    const moderation = new ChatModeration({ maxMessages: 3, windowMilliseconds: 5_000, bannedWords: [] }, () => now);
    expect(moderation.validate("public one", "server-a").accepted).toBe(true);
    now += 1_000;
    expect(moderation.validate("team two", "server-a").accepted).toBe(true);
    now += 1_000;
    expect(moderation.validate("public three", "server-a").accepted).toBe(true);
    const rejected = moderation.validate("team four", "server-a");
    expect(rejected).toMatchObject({ accepted: false, reason: "rate-limit", cooldownMilliseconds: 3_000 });
    now = 6_001;
    expect(moderation.validate("after window", "server-a").accepted).toBe(true);
  });

  it("keeps a server bucket across rapid reconnects but isolates another server", () => {
    const moderation = new ChatModeration({ maxMessages: 1, bannedWords: [] }, () => 1_000);
    expect(moderation.validate("first connection", "server-a").accepted).toBe(true);
    expect(moderation.validate("reconnected", "server-a").accepted).toBe(false);
    expect(moderation.validate("changed server", "server-b").accepted).toBe(true);
  });

  it("normalizes accents, compatibility forms, leetspeak, and common Unicode confusables", () => {
    expect(normalizeChatWord("Ｈìtl3r")).toBe("hitler");
    expect(containsBannedChatWord("hіtler", ["hitler"])).toBe(true);
    expect(containsBannedChatWord("h.i.t.l.e.r", ["hitler"])).toBe(true);
  });

  it("matches prohibited terms case-insensitively at Unicode word boundaries", () => {
    expect(containsBannedChatWord("HITLER!", ["hitler"])).toBe(true);
    expect(containsBannedChatWord("a ch1nk?", ["chink"])).toBe(true);
    expect(containsBannedChatWord("chinkapin trees and Scunthorpe", ["chink", "cunt"])).toBe(false);
  });
});
