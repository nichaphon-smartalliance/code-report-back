import { describe, expect, test } from "bun:test";
import { parseSeedUsers } from "../src/scripts/seed-users.ts";

describe("parseSeedUsers", () => {
  test("parses a well-formed seed file", () => {
    expect(
      parseSeedUsers(
        '[{"username":" ceo ","displayName":"CEO","password":"pw"}]',
      ),
    ).toEqual([{ username: "ceo", displayName: "CEO", password: "pw" }]);
  });

  test("rejects malformed input with a message naming the entry", () => {
    expect(() => parseSeedUsers("not json")).toThrow(/valid JSON/);
    expect(() => parseSeedUsers('{"username":"a"}')).toThrow(/array/);
    expect(() => parseSeedUsers('[{"displayName":"A","password":"p"}]')).toThrow(
      /entry #1/,
    );
    expect(() => parseSeedUsers('[{"username":"a","password":"p"}]')).toThrow(
      /displayName/,
    );
    expect(() => parseSeedUsers('[{"username":"a","displayName":"A"}]')).toThrow(
      /password/,
    );
  });
});
