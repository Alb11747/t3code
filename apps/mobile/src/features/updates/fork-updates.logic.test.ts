import { describe, expect, it } from "vite-plus/test";
import { selectForkUpdate } from "./fork-updates.logic";
function release(tag = "android-fork-202611151234-abcdef") {
  return {
    draft: false,
    tag_name: tag,
    assets: ["update.json", "update.json.sig"].map((name) => ({
      name,
      browser_download_url: `https://github.com/Alb11747/t3code/releases/download/${tag}/${name}`,
    })),
  };
}
describe("selectForkUpdate", () => {
  it("selects newest published Android release and excludes desktop releases and drafts", () => {
    const newest = release("android-fork-202611151235-abcdef");
    expect(
      selectForkUpdate([
        release(),
        { ...release("android-fork-202611151236-abcdef"), draft: true },
        { draft: false, tag_name: "v0.1.9-nightly.20261115.1.fork.1" },
        newest,
      ]).manifestUrl,
    ).toBe(newest.assets[0]?.browser_download_url);
  });
  it("rejects foreign asset URLs, incomplete releases and malformed feeds", () => {
    const invalid = release();
    invalid.assets[0]!.browser_download_url = "https://github.com/another/repo/update.json";
    expect(() => selectForkUpdate([invalid])).toThrow("invalid update.json");
    expect(() => selectForkUpdate([{ ...release(), assets: [] }])).toThrow("Missing");
    expect(() => selectForkUpdate([])).toThrow("No Android");
    expect(() => selectForkUpdate({})).toThrow("Invalid fork");
    expect(() =>
      selectForkUpdate([null, 1, { draft: false, tag_name: "android-fork-evil" }]),
    ).toThrow("No Android");
  });
});
