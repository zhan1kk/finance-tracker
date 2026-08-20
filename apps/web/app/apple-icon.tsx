import { ImageResponse } from "next/og";

/**
 * Home-screen icon for iOS, which ignores the web manifest's icons and needs a
 * PNG at `apple-touch-icon`. Without it, adding the site to a phone's home
 * screen produces a screenshot of the page instead of an icon.
 *
 * Drawn here rather than committed as a binary so it stays in step with
 * public/icon.svg — same dark tile, same three ascending bars.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  const bar = (height: number) => (
    <div
      style={{
        width: 25,
        height,
        borderRadius: 6,
        background: "#3987e5",
      }}
    />
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          gap: 13,
          paddingBottom: 39,
          background: "#18181b",
        }}
      >
        {bar(45)}
        {bar(73)}
        {bar(101)}
      </div>
    ),
    size,
  );
}
