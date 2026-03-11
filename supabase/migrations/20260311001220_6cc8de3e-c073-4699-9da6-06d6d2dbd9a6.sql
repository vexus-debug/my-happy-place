
-- Drop the existing RESTRICTIVE policy and recreate as PERMISSIVE
DROP POLICY IF EXISTS "Anyone can read scan cache" ON public.scan_cache;
CREATE POLICY "Anyone can read scan cache"
  ON public.scan_cache
  FOR SELECT
  TO anon, authenticated
  USING (true);
