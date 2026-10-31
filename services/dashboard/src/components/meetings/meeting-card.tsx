"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { formatDistanceToNow, format } from "date-fns";
import { Clock, ChevronRight, Calendar, MessageSquare, FileText, Pencil, Check, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Meeting } from "@/types/tina";
import { getDetailedStatus } from "@/types/tina";
import { cn, parseUTCTimestamp } from "@/lib/utils";
import { useMeetingsStore } from "@/stores/meetings-store";
import { toast } from "sonner";

interface MeetingCardProps {
  meeting: Meeting;
}

import { PlatformIcon } from "@/components/ui/platform-icon";

export function MeetingCard({ meeting }: MeetingCardProps) {
  const statusConfig = getDetailedStatus(meeting.status, meeting.data);
  const updateMeetingData = useMeetingsStore((state) => state.updateMeetingData);
  const isGoogleMeet = meeting.platform === "google_meet";
  // Display title from API data (name or title field)
  const displayTitle = meeting.data?.name || meeting.data?.title;
  const isActive = meeting.status === "active";
  
  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState("");
  const [isSavingTitle, setIsSavingTitle] = useState(false);

  // v0.10.5.3 Pack D-1 (#265): use parseUTCTimestamp consistently so the
  // unsuffixed-ISO timestamps the API returns are interpreted as UTC. Then
  // date-fns format() / toLocaleString() render in the browser's local
  // timezone (resolved via Intl.DateTimeFormat().resolvedOptions().timeZone).
  // Pre-fix: new Date(...) was interpreting unsuffixed ISO as local-time,
  // producing displayed times shifted by the user's UTC offset.
  const browserTz = typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";
  const duration = meeting.start_time && meeting.end_time
    ? Math.round(
        (parseUTCTimestamp(meeting.end_time).getTime()
          - parseUTCTimestamp(meeting.start_time).getTime()) / 60000
      )
    : null;

  const formatDuration = (minutes: number) => {
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  };

  // Build detailed status info for tooltip
  const getStatusTooltipContent = () => {
    const lines: string[] = [];
    
    // Status description
    if (statusConfig.description) {
      lines.push(statusConfig.description);
    }
    
    // Completion reason details
    if (meeting.data?.completion_reason) {
      const reason = meeting.data.completion_reason;
      if (reason !== "stopped" && reason !== "meeting_ended") {
        const formattedReason = reason
          .split("_")
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
        lines.push(`Reason: ${formattedReason}`);
      }
    }
    
    // Status transitions summary
    if (meeting.data?.status_transition && meeting.data.status_transition.length > 0) {
      const transitions = meeting.data.status_transition;
      const lastTransition = transitions[transitions.length - 1];
      
      if (lastTransition.timestamp) {
        try {
          const timestamp = parseUTCTimestamp(lastTransition.timestamp);
          lines.push(`Last updated: ${formatDistanceToNow(timestamp, { addSuffix: true })}`);
        } catch (e) {
          // Ignore parsing errors
        }
      }
      
      // Show transition count if more than 1
      if (transitions.length > 1) {
        lines.push(`${transitions.length} status changes`);
      }
    }
    
    // Start/end times if available
    if (meeting.start_time) {
      try {
        const startTime = parseUTCTimestamp(meeting.start_time);
        lines.push(`Started: ${format(startTime, "MMM d, HH:mm")}`);
      } catch (e) {
        // Ignore parsing errors
      }
    }
    
    if (meeting.end_time) {
      try {
        const endTime = parseUTCTimestamp(meeting.end_time);
        lines.push(`Ended: ${format(endTime, "MMM d, HH:mm")}`);
      } catch (e) {
        // Ignore parsing errors
      }
    }
    
    return lines;
  };

  const tooltipContent = getStatusTooltipContent();

  // Handle title editing
  const handleStartEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditedTitle(displayTitle || "");
    setIsEditingTitle(true);
  };

  const handleSaveTitle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!editedTitle.trim()) {
      setIsEditingTitle(false);
      return;
    }
    setIsSavingTitle(true);
    try {
      await updateMeetingData(meeting.platform, meeting.platform_specific_id, {
        name: editedTitle.trim(),
      });
      setIsEditingTitle(false);
      toast.success("Title updated");
    } catch (error) {
      toast.error("Failed to update title");
    } finally {
      setIsSavingTitle(false);
    }
  };

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsEditingTitle(false);
    setEditedTitle("");
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && editedTitle.trim() && !isSavingTitle) {
      e.preventDefault();
      e.stopPropagation();
      setIsSavingTitle(true);
      try {
        await updateMeetingData(meeting.platform, meeting.platform_specific_id, {
          name: editedTitle.trim(),
        });
        setIsEditingTitle(false);
        toast.success("Title updated");
      } catch (error) {
        toast.error("Failed to update title");
      } finally {
        setIsSavingTitle(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setIsEditingTitle(false);
      setEditedTitle("");
    }
  };

  const getStatusTokenClass = (status: string) => {
    if (status === "active") return "bg-[var(--accepted-bg)] text-[var(--accepted)] border-[var(--accepted)]/25";
    if (status === "completed") return "bg-[var(--accepted-bg)] text-[var(--accepted)] border-[var(--accepted)]/25";
    if (status === "awaiting_admission" || status === "joining" || status === "requested") return "bg-[var(--pending-bg)] text-[var(--pending)] border-[var(--pending)]/25";
    if (status === "failed") return "bg-[var(--rejected-bg)] text-[var(--rejected)] border-[var(--rejected)]/25";
    return "bg-[var(--draft-bg)] text-[var(--draft)] border-[var(--draft)]/25";
  };

  return (
    <Link href={`/meetings/${meeting.id}`} className="block group" onClick={(e) => isEditingTitle && e.preventDefault()}>
      <Card className={cn(
        "relative overflow-hidden transition-all duration-200 ease-out",
        "border border-border/80 bg-card",
        "hover:border-foreground/30 hover:shadow-sm",
        isActive && "border-primary/80 ring-1 ring-primary/30"
      )}>
        <div className="py-3.5 px-4">
          <div className="flex items-center gap-3.5">
            {/* Platform Icon */}
            <div className="flex-shrink-0 relative">
              <div className="w-10 h-10 rounded-lg border border-border/70 bg-subtle/50 flex items-center justify-center text-foreground transition-colors group-hover:border-primary/40">
                <PlatformIcon platform={meeting.platform} className="h-5 w-5" />
              </div>
              {/* Active indicator */}
              {isActive && (
                <div className="absolute -top-1 -right-1">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--brand)] opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--brand)] border-2 border-background" />
                  </span>
                </div>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 space-y-1">
              {/* Header row */}
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {isEditingTitle ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={editedTitle}
                        onChange={(e) => setEditedTitle(e.target.value)}
                        className="font-display text-base font-normal h-8 flex-1"
                        placeholder="Meeting title..."
                        autoFocus
                        disabled={isSavingTitle}
                        onKeyDown={handleKeyDown}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={handleSaveTitle}
                        disabled={isSavingTitle}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={handleCancelEdit}
                        disabled={isSavingTitle}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 group/title">
                      <h3 className={cn(
                        "font-display text-lg font-normal tracking-[-0.015em] text-foreground truncate",
                        "transition-colors duration-150",
                        "group-hover:text-primary"
                      )}>
                        {displayTitle || meeting.platform_specific_id}
                      </h3>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 opacity-0 group-hover/title:opacity-100 transition-opacity"
                        onClick={handleStartEdit}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                  {meeting.data?.participants && meeting.data.participants.length > 0 ? (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      With {meeting.data.participants.slice(0, 3).join(", ")}
                      {meeting.data.participants.length > 3 && ` +${meeting.data.participants.length - 3}`}
                    </p>
                  ) : displayTitle && !isEditingTitle && (
                    <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                      {meeting.platform_specific_id}
                    </p>
                  )}
                </div>

                {/* Status badge with tooltip */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "flex-shrink-0 text-xs font-medium px-2 py-0.5 cursor-help rounded-full border",
                          getStatusTokenClass(meeting.status),
                          isActive && "animate-pulse"
                        )}
                      >
                        {statusConfig.label}
                      </Badge>
                    </div>
                  </TooltipTrigger>
                  {tooltipContent.length > 0 && (
                    <TooltipContent side="top" className="max-w-xs">
                      <div className="space-y-1">
                        {tooltipContent.map((line, index) => (
                          <div key={index} className="text-xs">
                            {line}
                          </div>
                        ))}
                      </div>
                    </TooltipContent>
                  )}
                </Tooltip>
              </div>

              {/* Status description */}
              {statusConfig.description && (
                <div className="text-xs text-muted-foreground">
                  {statusConfig.description}
                </div>
              )}

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {meeting.start_time && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1.5 text-muted-foreground cursor-help">
                        <Calendar className="h-3.5 w-3.5" />
                        <span>{format(parseUTCTimestamp(meeting.start_time), "MMM d, yyyy")}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p className="text-xs">
                        {parseUTCTimestamp(meeting.start_time).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "long",
                          timeZone: browserTz,
                        })}
                      </p>
                      <p className="text-[11px] text-muted-foreground/80">
                        UTC: {format(parseUTCTimestamp(meeting.start_time), "yyyy-MM-dd HH:mm:ss 'UTC'")}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {meeting.start_time && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    <span>{formatDistanceToNow(parseUTCTimestamp(meeting.start_time), { addSuffix: true })}</span>
                  </div>
                )}

                {duration && (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted/50">
                    <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">{formatDuration(duration)}</span>
                  </div>
                )}

                {meeting.data?.notes && meeting.data.notes.trim() && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1.5 text-muted-foreground cursor-help">
                        <FileText className="h-3.5 w-3.5" />
                        <span>Note</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <div className="text-xs">
                        <div className="font-medium mb-1">Note:</div>
                        <div className="text-muted-foreground">
                          {typeof meeting.data.notes === "string" && meeting.data.notes.length > 100
                            ? `${meeting.data.notes.substring(0, 100)}...`
                            : String(meeting.data.notes)}
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

            </div>

            {/* Arrow */}
            <div className={cn(
              "flex-shrink-0 self-center",
              "p-1.5 rounded-full",
              "transition-all duration-300",
              "group-hover:bg-primary/10",
              "group-hover:translate-x-1"
            )}>
              <ChevronRight className={cn(
                "h-4 w-4 text-muted-foreground",
                "transition-colors duration-200",
                "group-hover:text-primary"
              )} />
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}
