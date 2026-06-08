// src/booking/calendarLink.js
import crypto from "node:crypto";
import { google } from "googleapis";
import { createGoogleAuth } from "./googleAuth.js";
import { withRetry } from "../util/retry.js";

/**
 * Pure builder for a Google Calendar event that requests a Meet link.
 * @param {{summary: string, attendeeEmail?: string, startIso: string, durationMinutes?: number}} input
 */
export function buildMeetEventPayload({ summary, attendeeEmail, startIso, durationMinutes = 30 }) {
  if (!attendeeEmail) throw new Error("attendeeEmail is required");
  const end = new Date(new Date(startIso).getTime() + durationMinutes * 60_000).toISOString();
  return {
    summary,
    start: { dateTime: startIso },
    end: { dateTime: end },
    attendees: [{ email: attendeeEmail }],
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" }
      }
    }
  };
}

/**
 * Create the event (sends the invite email automatically) and return the Meet link.
 * @param {{booking: object, summary: string, attendeeEmail: string, startIso: string, durationMinutes?: number, logger?: object}} args
 * @returns {Promise<{meetUrl: string, eventId: string, startIso: string}>}
 */
export async function createMeetEvent({ booking, summary, attendeeEmail, startIso, durationMinutes = 30, logger }) {
  const auth = createGoogleAuth(booking);
  const calendar = google.calendar({ version: "v3", auth });
  const requestBody = buildMeetEventPayload({ summary, attendeeEmail, startIso, durationMinutes });

  const response = await withRetry(
    () => calendar.events.insert({
      calendarId: booking.calendarId || "primary",
      conferenceDataVersion: 1,
      sendUpdates: "all",
      requestBody
    }),
    { retries: 2, baseDelayMs: 400, onRetry: (n, e) => logger?.warn?.(`Calendar insert retry ${n}: ${e.message}`) }
  );

  const event = response.data;
  const meetUrl =
    event.hangoutLink ||
    event.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ||
    "";
  if (!meetUrl) throw new Error("Calendar event created but no Meet link was returned.");
  return { meetUrl, eventId: event.id, startIso };
}
