function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
export function selectForkUpdate(response: unknown): { manifestUrl: string; signatureUrl: string } {
  if (!Array.isArray(response)) throw new Error("Invalid fork release response");
  const releases = response
    .flatMap((value: unknown) => {
      const release = record(value);
      return release?.draft === false &&
        typeof release.tag_name === "string" &&
        /^android-fork-\d{12}-[a-f0-9]+$/.test(release.tag_name)
        ? [{ assets: release.assets, tag_name: release.tag_name }]
        : [];
    })
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name));
  const release = releases[0];
  if (!release) throw new Error("No Android fork release is available yet");
  const assetUrl = (name: string) => {
    const asset = Array.isArray(release.assets)
      ? release.assets.map((value: unknown) => record(value)).find((entry) => entry?.name === name)
      : undefined;
    const expected = `https://github.com/Alb11747/t3code/releases/download/${release.tag_name}/${name}`;
    if (asset?.browser_download_url !== expected) throw new Error(`Missing or invalid ${name}`);
    return expected;
  };
  return { manifestUrl: assetUrl("update.json"), signatureUrl: assetUrl("update.json.sig") };
}
