import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "@azure/identity", "google-auth-library"],
};

export default nextConfig;
