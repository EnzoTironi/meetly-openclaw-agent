import { assertInvitation, endOf, invitation, type Details, type Event, type Invitation, type Slot } from "./model.ts";
import type { WriteEvent } from "./providers.ts";

export type Booking = { details: Details; chosen: Slot; marker: string; previous: Invitation | null };
function preferredLink(value: Booking): string {
  if (value.details.kind !== "video") return "";
  if (value.details.video.kind === "zoom_personal") return value.details.video.url;
  return value.previous?.event.conference || value.previous?.event.location || "";
}
export function invitationWrite(value: Booking): WriteEvent {
  const { details, chosen, marker, previous } = value;
  let location = "", conference: WriteEvent["conference"] = "none";
  switch (details.kind) {
    case "in_person": location = details.location; break;
    case "phone": location = details.phone; break;
    case "video":
      if (details.video.kind !== "google_meet") location = preferredLink(value);
      if (!previous) {
        if (details.video.kind === "google_meet") conference = "meet";
        if (details.video.kind === "zoom_new") conference = "zoom";
      }
  }
  return { calendar: chosen.meeting.calendar, start: chosen.start, end: endOf(chosen), title: details.topic,
    location, attendees: details.attendees, conference, marker };
}
export function verifyBooked(observed: Event, value: Booking): Invitation {
  const { details, chosen, previous } = value;
  let link = preferredLink(value), zoomId: string | null = null;
  if (details.kind === "video" && details.video.kind === "zoom_new") {
    link ||= observed.conference || observed.location;
    const match = /^https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/j\/(\d+)(?:\?pwd=[A-Za-z0-9._-]+)?$/.exec(link);
    if (!match?.[1]) throw new Error("The calendar has not verified the new Zoom meeting URL.");
    zoomId = match[1];
  }
  assertInvitation(observed, details, chosen, link);
  if (previous && details.kind === "video" && details.video.kind === "google_meet" && observed.conference !== previous.event.conference) {
    throw new Error("The moved invitation changed its saved Meet link.");
  }
  return invitation.parse({ event: observed, travel: chosen.travel, zoomId });
}
