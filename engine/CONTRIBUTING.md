# Contributing

Thanks for helping. Bug reports with a sample PDF (or a description of one, if
the file is private) are the most useful contribution.

## Before you open a pull request

- Run the tests: start the engine and run `python engine/tests/test_mcp.py`
  (see the README's "Building" section). Add a check for what you changed.
- Keep tool descriptions short and exact: agents read them to decide what to do.
- Never add a network call. The engine works offline by design; the only
  exception is the timestamp server a user explicitly passes to `pdf_sign`.

## License of contributions

The project is licensed under the Apache License 2.0 (the `LICENSE` file at the top of the repository).
Unless you say otherwise, a contribution you submit is licensed under the same
terms (section 5 of the license).
