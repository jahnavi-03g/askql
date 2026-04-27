"use client";

import dynamic from "next/dynamic";

const DashboardPage = dynamic(() => import("./dashboard/page"), {
  ssr: false,
  loading: () => (
    <div style={{ 
      minHeight: "100vh", 
      background: "#0a0a0f", 
      display: "flex", 
      alignItems: "center", 
      justifyContent: "center",
      color: "#666"
    }}>
      Loading...
    </div>
  ),
});

export default function HomePage() {
  return <DashboardPage />;
}