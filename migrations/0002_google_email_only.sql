-- Google verified email is the only sign-in identity. Keep phone numbers in school records
-- as optional contact details, but remove legacy phone-based login mappings and OTP challenges.
DELETE FROM logins WHERE instr(identifier, '@') = 0;
DROP TABLE IF EXISTS otps;
