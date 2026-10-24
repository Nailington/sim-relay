import { z } from 'zod';
import { feedbackSchema, qualitySchema } from '../host/adaptive';

/** The relay forwards only the additive protocol, never arbitrary websocket objects. */
export const mediaControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quality'), limits: qualitySchema.strict() }).strict(),
  z.object({ type: z.literal('video-feedback'), feedback: feedbackSchema.strict() }).strict(),
  z
    .object({ type: z.literal('media-pong'), sentAt: z.number().finite().min(0).max(1e12) })
    .strict(),
  z
    .object({
      type: z.literal('media-control'),
      id: z.string().uuid(),
      action: z.enum([
        'recording-start',
        'recording-stop',
        'recording-discard',
        'audio-start',
        'audio-stop',
      ]),
      hostAudioConsent: z.boolean().optional(),
    })
    .strict(),
]);
