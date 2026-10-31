import { AEC_RAW_MIC_CHANNEL } from '@tina/capture-codec';

export function isArchiveOnlyCaptureSource(speakerIndex: number): boolean {
  return speakerIndex === AEC_RAW_MIC_CHANNEL;
}
