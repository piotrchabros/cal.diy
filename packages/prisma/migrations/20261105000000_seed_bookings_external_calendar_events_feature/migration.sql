INSERT INTO "Feature" ("slug", "enabled", "type", "description", "createdAt", "updatedAt")
VALUES ('bookings-external-calendar-events', false, 'RELEASE', 'Show the user''s own calendar events that were not booked through Cal.diy on the bookings pages', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
