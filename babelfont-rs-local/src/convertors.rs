#[cfg(feature = "fontir")]
/// fontc's Font Intermediate Representation (FIR) convertor
pub mod fontir;

#[cfg(feature = "ufo")]
/// Designspace/UFO convertor
pub mod designspace;
#[cfg(feature = "fontlab")]
/// Fontlab convertor
pub mod fontlab;
#[cfg(feature = "fontra")]
/// Fontra convertor
pub mod fontra;
#[cfg(feature = "glyphs")]
/// Glyphs 3 convertor
pub mod glyphs3;
#[cfg(feature = "ufo")]
/// Bare UFO convertor
pub mod ufo;
