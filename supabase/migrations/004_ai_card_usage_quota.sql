-- Quota giornaliera per le chiamate AI di strutturazione biglietti da visita
-- (funzione structure-business-card). Il costo di queste chiamate è a
-- carico dello sviluppatore, non del cliente finale: questo tetto protegge
-- da costi imprevisti in caso di uso anomalo/eccessivo.
-- Esegui in Supabase → SQL Editor

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  usage_date date PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0
);

ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;
-- Nessuna policy pubblica: solo la edge function (service role) vi accede.

-- Incrementa in modo atomico il contatore del giorno corrente e ritorna
-- true se si è ancora entro il limite max_calls, false se già superato.
CREATE OR REPLACE FUNCTION increment_ai_usage(max_calls integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_calls integer;
BEGIN
  INSERT INTO ai_usage_daily (usage_date, calls)
  VALUES (CURRENT_DATE, 1)
  ON CONFLICT (usage_date) DO UPDATE SET calls = ai_usage_daily.calls + 1
  RETURNING calls INTO current_calls;

  RETURN current_calls <= max_calls;
END;
$$;
