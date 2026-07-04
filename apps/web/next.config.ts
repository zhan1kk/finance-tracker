import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Proxy the API under /api so requests are same-origin (cookies flow, no CORS).
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
