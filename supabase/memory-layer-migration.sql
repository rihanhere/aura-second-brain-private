do $$
begin
  alter type memory_layer add value if not exists 'core_profile';
  alter type memory_layer add value if not exists 'episodic';
  alter type memory_layer add value if not exists 'session_summary';
end $$;
