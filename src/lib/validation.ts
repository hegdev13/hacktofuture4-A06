import { z } from "zod";

export const NgrokUrlSchema = z
  .string()
  .trim()
  .url()
  .refine(
    (u) => {
      try {
        const url = new URL(u);
        if (url.protocol !== "https:") return false;
        const host = url.hostname.toLowerCase();
        return host.endsWith(".ngrok-free.app") || host.endsWith(".ngrok.app") || host.endsWith(".ngrok.io");
      } catch {
        return false;
      }
    },
    { message: "Must be a valid https ngrok URL" },
  );

export const CreateEndpointSchema = z.object({
  name: z.string().trim().min(2).max(80),
  ngrok_url: NgrokUrlSchema,
});

