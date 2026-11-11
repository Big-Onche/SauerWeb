import { describe, expect, it } from "vitest";
import { parseMasterServerList } from "./relay.mjs";

describe("parseMasterServerList", () => {
  it("parses and deduplicates the original addserver format", () => {
    expect(parseMasterServerList([
      "echo Sauerbraten server list",
      "addserver 192.0.2.1 28785",
      "addserver play.example.net 30000",
      "addserver 192.0.2.1 28785",
      "",
    ].join("\n"))).toEqual([
      { host: "192.0.2.1", port: 28785, label: "192.0.2.1" },
      { host: "play.example.net", port: 30000, label: "play.example.net" },
    ]);
  });

  it("ignores malformed and unsafe destinations", () => {
    expect(parseMasterServerList([
      "addserver example.net 0",
      "addserver example.net 65535",
      "addserver bad/host 28785",
      "addserver -bad.example 28785",
      "addserver example.net not-a-port",
      "addserver example.net 28785 password",
    ].join("\n"))).toEqual([]);
  });
});
