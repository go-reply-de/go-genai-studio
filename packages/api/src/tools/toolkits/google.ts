import { z } from 'zod';
export const googleToolkit = {
    imagen: {
        name: 'imagen',
        description:
            'Generates one or more images using Google Vertex AI Imagen from a text prompt. Use this for creating original images.',
        schema: z.object({
            prompt: z.string().min(1).max(4000).describe('A detailed text prompt for the image.'),
            n: z
                .number()
                .int()
                .min(1)
                .max(8)
                .optional()
                .describe('Number of images to generate (1-8). Defaults to 1.'),
            resolution: z
                .enum(['1K', '2K'])
                .optional()
                .describe("Image resolution: '1K' or '2K'. Defaults to '1K'."),
            size: z
                .enum(['1:1', '16:9', '9:16', '4:3', '3:4'])
                .optional()
                .describe("Aspect ratio of the image. Defaults to '1:1'."),
            negativePrompt: z
                .string()
                .optional()
                .describe('A prompt of what to exclude from the image.'),
        }),
        responseFormat: 'content_and_artifact',
    } as const,
} as const;