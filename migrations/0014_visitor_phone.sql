-- Visitor mobile number (E.164) for texting the door code. Personal data:
-- erased with name/email/company (on request, or retentionDays after the visit).
ALTER TABLE visits ADD COLUMN visitor_phone TEXT;
