## Cost Tracking Table Setup

The cost tracking API requires the `gemini_cost_records` table in Supabase.

### Quick Setup

1. **Go to your Supabase Dashboard**:
   - URL: https://app.supabase.com
   - Select your project: `cdsgtuoslttfjcvnpvta`

2. **Open SQL Editor**:
   - Click "SQL Editor" in the left sidebar
   - Click "+ New Query"

3. **Run the SQL Migration**:
   - Copy the SQL from `supabase/sql/003_gemini_cost_tracking.sql`
   - Paste it into the SQL editor
   - Click "Run"

4. **Verify Table was Created**:
   - Go to "Table Editor" in the left sidebar
   - Look for `gemini_cost_records` table
   - You should see columns: id, stage, input_tokens, output_tokens, total_tokens, cost_usd, model, scenario, issue_id, created_at

### Automated Setup (Alternative)

If you have Supabase CLI installed:
```bash
supabase db push --debug
```

### What the Table Does

- **stage**: "plan", "options", or "summary" - which Gemini call generated the tokens
- **input_tokens**: Tokens sent to Gemini
- **output_tokens**: Tokens received from Gemini
- **total_tokens**: sum of input + output
- **cost_usd**: Calculated cost in USD
- **model**: Always "gemini-1.5-flash"
- **scenario**: e.g., "pod-crash", "cpu-spike"
- **issue_id**: Links all 3 stages of one healing event
- **created_at**: When this cost record was created

### Troubleshooting

**"Could not find the table 'public.gemini_cost_records' in the schema cache"**
→ Run the SQL migration above

**API still shows demo data after table creation**
→ Make sure RLS policies were created correctly or disable RLS:
  - Go to Table Editor
  - Click `gemini_cost_records`
  - Click "Auth" tab
  - Toggle "Enable RLS" OFF temporarily to test
