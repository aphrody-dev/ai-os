import ghidra.GhidraApplicationLayout;
import ghidra.GhidraLaunchable;

/** Entry point for `ghidra.Ghidra GhidraBridge` (the Ghidra launcher only accepts GhidraLaunchable). */
public final class GhidraBridge implements GhidraLaunchable {
  @Override
  public void launch(GhidraApplicationLayout layout, String[] args) throws Exception {
    Bridge.launchLayout = layout;
    Bridge.main(args);
  }
}
