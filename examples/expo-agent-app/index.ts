import { registerRootComponent } from "expo";
// Loaded first: registers the Android background push handler before any UI.
import "./src/hainiva";
import App from "./App";

registerRootComponent(App);
