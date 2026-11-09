import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { entryScript, UpdateNotice } from "../src/components/update-notice.tsx";

const page = (src: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${src}"></script>` +
  `<link rel="stylesheet" href="/assets/index-x.css"></head><body></body></html>`;

/** The tab coming back into view, as it does when someone returns to it. */
const returnToTab = () => act(async () => void window.dispatchEvent(new Event("focus")));

describe("entryScript", () => {
  it("names the build a page loads by its content-hashed entry script", () => {
    expect(entryScript(page("/assets/index-CrQ2m0HA.js"))).toBe("/assets/index-CrQ2m0HA.js");
    expect(entryScript("<html><body>no scripts</body></html>")).toBeNull();
  });
});

describe("UpdateNotice", () => {
  it("offers a reload when the tab returns and the server has a newer build", async () => {
    const reload = vi.fn();
    const latest = vi.fn(async () => page("/assets/index-NEW.js"));
    render(<UpdateNotice current="/assets/index-OLD.js" latest={latest} reload={reload} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await returnToTab();
    expect(await screen.findByRole("status")).toHaveTextContent(/highground has been updated/i);
    await userEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("stays quiet when the server's build is the one running, or cannot be fetched", async () => {
    const same = vi.fn(async () => page("/assets/index-OLD.js"));
    const { unmount } = render(
      <UpdateNotice current="/assets/index-OLD.js" latest={same} reload={vi.fn()} />,
    );
    await returnToTab();
    expect(same).toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    unmount();

    const failing = vi.fn(async () => Promise.reject(new Error("server restarting")));
    render(<UpdateNotice current="/assets/index-OLD.js" latest={failing} reload={vi.fn()} />);
    await returnToTab();
    expect(failing).toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("checks nothing when the running page names no build, as under the dev server", async () => {
    const latest = vi.fn(async () => page("/assets/index-NEW.js"));
    render(<UpdateNotice current={null} latest={latest} reload={vi.fn()} />);
    await returnToTab();
    expect(latest).not.toHaveBeenCalled();
  });
});
