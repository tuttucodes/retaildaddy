import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMeetEventPayload } from "../src/booking/calendarLink.js";

describe("buildMeetEventPayload", () => {
  it("creates a 30-min event with a Meet conference request and attendee", () => {
    const startIso = "2026-06-10T10:00:00.000Z";
    const payload = buildMeetEventPayload({
      summary: "RetailDaddy demo with Rahul",
      attendeeEmail: "rahul@gmail.com",
      startIso,
      durationMinutes: 30
    });
    assert.equal(payload.summary, "RetailDaddy demo with Rahul");
    assert.equal(payload.start.dateTime, startIso);
    assert.equal(payload.end.dateTime, "2026-06-10T10:30:00.000Z");
    assert.deepEqual(payload.attendees, [{ email: "rahul@gmail.com" }]);
    assert.ok(payload.conferenceData.createRequest.conferenceSolutionKey.type === "hangoutsMeet");
    assert.ok(payload.conferenceData.createRequest.requestId.length > 0);
  });

  it("throws on a missing attendee email", () => {
    assert.throws(() => buildMeetEventPayload({ summary: "x", startIso: "2026-06-10T10:00:00.000Z" }), /attendeeEmail/);
  });
});
