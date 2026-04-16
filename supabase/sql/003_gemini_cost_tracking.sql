-- Create gemini_cost_records table for cost tracking
CREATE TABLE IF NOT EXISTS public.gemini_cost_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stage TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd DECIMAL(10, 6),
  model TEXT,
  scenario TEXT,
  issue_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_gemini_cost_stage ON public.gemini_cost_records(stage);
CREATE INDEX IF NOT EXISTS idx_gemini_cost_created_at ON public.gemini_cost_records(created_at);
CREATE INDEX IF NOT EXISTS idx_gemini_cost_issue_id ON public.gemini_cost_records(issue_id);

-- Enable RLS if needed
ALTER TABLE public.gemini_cost_records ENABLE ROW LEVEL SECURITY;

-- Allow anon key to read/insert
DROP POLICY IF EXISTS "Allow anon to read cost records" ON public.gemini_cost_records;
DROP POLICY IF EXISTS "Allow anon to insert cost records" ON public.gemini_cost_records;

CREATE POLICY "Allow anon to read cost records" 
  ON public.gemini_cost_records FOR SELECT 
  USING (true);

CREATE POLICY "Allow anon to insert cost records"
  ON public.gemini_cost_records FOR INSERT
  WITH CHECK (true);
