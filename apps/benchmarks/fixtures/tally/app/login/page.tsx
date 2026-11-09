import { users } from "../../lib/users";
import { signIn } from "./actions";

export default function LoginPage() {
  return (
    <main className="content">
      <h1>Sign in to Tally</h1>
      <form action={signIn}>
        <label>
          Account{" "}
          <select name="userId">
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} ({user.email})
              </option>
            ))}
          </select>
        </label>{" "}
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
