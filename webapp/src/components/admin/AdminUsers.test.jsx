import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import AdminUsers from "../../pages/admin/AdminUsers";
import {
  createUser,
  getUsers,
} from "../../api/musicdeck";


jest.mock("../../api/musicdeck", () => ({
  createUser: jest.fn(),
  getUsers: jest.fn(),
}));

jest.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ session: { id: "admin-1", username: "admin", role: "admin" } }),
}));


const USERS = [
  {
    id: "admin-1",
    username: "admin",
    displayName: "Admin",
    role: "admin",
    disabled: false,
  },
  {
    id: "user-1",
    username: "listener",
    displayName: "Listener",
    role: "user",
    disabled: false,
  },
  {
    id: "user-2",
    username: "disabledlistener",
    displayName: "Disabled",
    role: "user",
    disabled: true,
  },
];


beforeEach(() => {
  jest.clearAllMocks();
  getUsers.mockResolvedValue(USERS);
  window.confirm = jest.fn(() => true);
});

function renderUsers() {
  return render(
    <MemoryRouter>
      <AdminUsers />
      <LocationProbe />
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}


describe("Users page", () => {
  test("lists users", async () => {
    renderUsers();

    expect(await screen.findByText("listener")).toBeInTheDocument();
    expect(
      screen.getAllByText("admin").length
    ).toBeGreaterThan(0);
  });

  test("renders exactly one Add User action and one page title", async () => {
    renderUsers();

    await screen.findByText("listener");

    expect(
      screen.getAllByRole("button", { name: /\+ add user/i })
    ).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "Users" })).toHaveLength(1);
    expect(screen.getAllByLabelText(/search users/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/filter users/i)).toHaveLength(1);
    expect(
      screen.getAllByRole("row", { name: /name\s+role\s+status\s+last active/i })
    ).toHaveLength(1);
  });

  test("renders each user row exactly once", async () => {
    renderUsers();

    await screen.findByText("listener");

    expect(screen.getAllByText("listener")).toHaveLength(1);
    expect(screen.getAllByText("disabledlistener")).toHaveLength(1);
  });

  test("searches users by name", async () => {
    renderUsers();

    await screen.findByText("listener");

    fireEvent.change(screen.getByLabelText(/search users/i), {
      target: { value: "disabledlist" },
    });

    expect(screen.getByText("disabledlistener")).toBeInTheDocument();
    expect(screen.queryByText("listener")).not.toBeInTheDocument();
  });

  test("filters users by role", async () => {
    renderUsers();

    await screen.findByText("listener");

    fireEvent.change(screen.getByLabelText(/filter users/i), {
      target: { value: "admin" },
    });

    // Only the admin account remains; regular users are filtered out.
    expect(screen.queryByText("listener")).not.toBeInTheDocument();
    expect(screen.queryByText("disabledlistener")).not.toBeInTheDocument();
  });

  test("opens the user management view when clicking a user", async () => {
    renderUsers();

    await screen.findByText("listener");

    fireEvent.click(screen.getByRole("row", { name: /^Listener/i }));
    expect(screen.getByTestId("location")).toHaveTextContent("/admin/users/user-1");
  });

  test("creates a new user", async () => {
    createUser.mockResolvedValue({
      id: "user-3",
      username: "newbie",
      displayName: "Newbie",
      role: "user",
      disabled: false,
    });

    renderUsers();

    await screen.findByText("listener");

    fireEvent.click(screen.getByRole("button", { name: /\+ add user/i }));

    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: "newbie" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "supersecret1" },
    });

    fireEvent.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() =>
      expect(createUser).toHaveBeenCalledWith({
        username: "newbie",
        password: "supersecret1",
        displayName: undefined,
        role: "user",
      })
    );
  });
});
