import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile).
  output: "standalone",
  experimental: {
    // The dev rewrite proxy kills upstream requests after 30s by default. An
    // LLM-categorized CSV import legitimately runs longer than that, and the
    // proxy's failure mode is a bare "Internal Server Error" while the API
    // finishes fine in the background. Dev-only concern: in production Caddy
    // proxies the API without this timeout.
    proxyTimeout: 300_000,
  },
  // Proxy the API under /api so requests are same-origin (cookies flow, no CORS).
  // Note: resolved at build time — the Docker image bakes API_URL in.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_URL ?? "http://localhost:3000"}/:path*`,
      },
    ];
  },
};

export default nextConfig;
