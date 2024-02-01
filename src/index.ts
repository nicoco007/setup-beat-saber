import { info, setFailed } from "@actions/core";
import { run } from "./main.js";

run()
    .catch((error: Error) => setFailed(error.message))
    .then(() => info("Complete!"));