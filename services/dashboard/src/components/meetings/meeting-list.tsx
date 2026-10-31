"use client";

import { Video, Plus, Sparkles } from "lucide-react";
import { MeetingCard } from "./meeting-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useJoinModalStore } from "@/stores/join-modal-store";
import type { Meeting } from "@/types/tina";
import { cn } from "@/lib/utils";

interface MeetingListProps {
  meetings: Meeting[];
  isLoading?: boolean;
  limit?: number;
  emptyMessage?: string;
  showJoinCTA?: boolean;
}

export function MeetingList({
  meetings,
  isLoading,
  limit,
  emptyMessage = "No meetings found",
  showJoinCTA = true,
}: MeetingListProps) {
  const openJoinModal = useJoinModalStore((state) => state.openModal);

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[...Array(limit || 3)].map((_, i) => (
          <MeetingCardSkeleton key={i} index={i} />
        ))}
      </div>
    );
  }

  const displayedMeetings = limit ? meetings.slice(0, limit) : meetings;

  if (displayedMeetings.length === 0) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-card/60">
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
          <div className="w-14 h-14 rounded-2xl bg-subtle border border-border/80 flex items-center justify-center text-foreground mb-5">
            <Video className="h-7 w-7 text-primary" />
          </div>

          <h3 className="font-display text-2xl font-normal mb-2 text-foreground">
            Chưa có cuộc họp nào
          </h3>
          <p className="text-muted-foreground text-center max-w-sm mb-6 leading-relaxed text-sm">
            {emptyMessage || "Lắng nghe rõ. Cùng làm đúng. Bắt đầu phiên âm cuộc họp đầu tiên để lưu lại tri thức tổ chức."}
          </p>

          {showJoinCTA && (
            <Button
              onClick={openJoinModal}
              size="lg"
              className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium shadow-sm transition-all"
            >
              <Plus className="h-4 w-4 mr-2" />
              Thả bot vào cuộc họp
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {displayedMeetings.map((meeting, index) => (
        <div
          key={`${meeting.id}-${meeting.platform_specific_id}-${index}`}
          className="animate-fade-in"
          style={{ animationDelay: `${index * 40}ms`, animationFillMode: "backwards" }}
        >
          <MeetingCard meeting={meeting} />
        </div>
      ))}
    </div>
  );
}

function MeetingCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border/70 bg-card p-4 shadow-sm animate-fade-in",
      )}
      style={{ animationDelay: `${index * 80}ms`, animationFillMode: "backwards" }}
    >
      <div className="flex items-center gap-3.5">
        {/* Icon skeleton */}
        <Skeleton className="h-10 w-10 rounded-lg flex-shrink-0" />

        <div className="flex-1 space-y-2">
          {/* Title and status */}
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>

          {/* Meta info */}
          <div className="flex items-center gap-3">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3.5 w-16" />
          </div>
        </div>

        {/* Arrow skeleton */}
        <Skeleton className="h-7 w-7 rounded-full flex-shrink-0" />
      </div>
    </div>
  );
}
