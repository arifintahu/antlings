// Stand-in for gh and claude in tests. FAKE_OUT is printed, FAKE_CODE is the exit code.
process.stdout.write(process.env.FAKE_OUT ?? '');
process.exit(Number(process.env.FAKE_CODE ?? 0));
