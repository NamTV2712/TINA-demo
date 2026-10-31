import type { ChunkSegment } from '@tina/mixed-pipeline';
import type { TranscriptSegment } from '@tina/gmeet-pipeline';

export function mixedSegment(connection: string, channel: number, segment: ChunkSegment, speaker: string, completed: boolean): TranscriptSegment {
  // Each mic/mixed transcriber and reconnect restarts turn counters at zero.
  return { speaker_key:`ch-${channel}:${connection}:${segment.segmentId}`,
    segment_id:`${connection}:ch-${channel}:${segment.segmentId}`, speaker, text:segment.text,
    start:segment.startMs/1000,end:segment.endMs/1000,language:segment.language,completed };
}
