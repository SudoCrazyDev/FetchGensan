import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a second dev server (e.g. one pointed at the local Supabase stack,
  // see .claude/launch.json "admin-local") run beside the usual one -- Next
  // refuses two dev servers sharing a build directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
