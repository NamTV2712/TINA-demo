import { cn } from "@/lib/utils";
import { Monitor, Video } from "lucide-react";

export interface PlatformIconProps {
  platform: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function GoogleMeetIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("w-5 h-5", className)}
      aria-label="Google Meet"
    >
      <rect x="2.5" y="5.5" width="13" height="13" rx="3" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M15.5 10.25l4.8-3.6a.75.75 0 0 1 1.2.6v9.5a.75.75 0 0 1-1.2.6l-4.8-3.6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TeamsIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("w-5 h-5", className)}
      aria-label="Microsoft Teams"
    >
      <rect x="3" y="5" width="13" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M16 8.5h3.5A2.5 2.5 0 0 1 22 11v5a2.5 2.5 0 0 1-2.5 2.5H16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path d="M6.5 10h6M9.5 10v6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function ZoomIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("w-5 h-5", className)}
      aria-label="Zoom"
    >
      <rect x="2.5" y="5.5" width="13" height="13" rx="3" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M15.5 10.25l4.8-3.6a.75.75 0 0 1 1.2.6v9.5a.75.75 0 0 1-1.2.6l-4.8-3.6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PlatformIcon({ platform, className, size = "md" }: PlatformIconProps) {
  const sizeMap = {
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-7 h-7",
  };

  const iconClass = cn(sizeMap[size], className);

  if (platform === "google_meet") {
    return <GoogleMeetIcon className={iconClass} />;
  }
  if (platform === "teams") {
    return <TeamsIcon className={iconClass} />;
  }
  if (platform === "browser_session") {
    return <Monitor className={iconClass} aria-label="Browser Session" />;
  }
  if (platform === "jitsi") {
    return <Video className={iconClass} aria-label="Jitsi Meet" />;
  }
  return <ZoomIcon className={iconClass} />;
}
