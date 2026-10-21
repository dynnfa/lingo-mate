import asyncio

from lingo_agent.runtime.server import main


def entry() -> None:
    try:
        asyncio.run(main())
    except (Exception, KeyboardInterrupt):
        raise SystemExit(1) from None


if __name__ == "__main__":
    entry()
