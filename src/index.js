import { info, setFailed } from "@actions/core";
import { main } from "./main";

main()
    .catch((error) => setFailed(error.message))
    .then(() => info("Complete!"));