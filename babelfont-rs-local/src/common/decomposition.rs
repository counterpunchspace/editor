pub(crate) struct DecomposedAffine {
    pub translation: (f64, f64),
    pub scale: (f64, f64),
    pub rotation: f64,
    // I don't care about skew
}

fn decompose<T: Into<f64>>(
    scale_x: T,
    scale_xy: T,
    scale_yx: T,
    scale_y: T,
    t_x: T,
    t_y: T,
) -> DecomposedAffine {
    let scale_x: f64 = scale_x.into();
    let scale_xy: f64 = scale_xy.into();
    let scale_yx: f64 = scale_yx.into();
    let scale_y: f64 = scale_y.into();
    let t_x: f64 = t_x.into();
    let t_y: f64 = t_y.into();

    let delta: f64 = scale_x * scale_y - scale_xy * scale_yx;
    let translation = (t_x, t_y);
    let (rotation, scale) = if scale_x != 0.0 || scale_xy != 0.0 {
        let r = (scale_x * scale_x + scale_xy * scale_xy).sqrt();
        let angle = if scale_xy > 0.0 {
            (scale_x / r).acos()
        } else {
            -(scale_x / r).acos()
        };
        (angle, (r, delta / r))
    } else if scale_yx != 0.0 || scale_y != 0.0 {
        let s = (scale_yx * scale_yx + scale_y * scale_y).sqrt();
        let angle = if scale_y > 0.0 {
            (scale_y / s).asin()
        } else {
            -(scale_y / s).asin()
        };
        ((std::f64::consts::PI / 2.0) - angle, (delta / s, s))
    } else {
        (0.0, (0.0, 0.0))
    };
    DecomposedAffine {
        translation,
        scale,
        rotation,
    }
}

impl From<kurbo::Affine> for DecomposedAffine {
    fn from(t: kurbo::Affine) -> Self {
        let [
            scale_x,
            scale_yx, // No, really.
            scale_xy,
            scale_y,
            t_x,
            t_y,
         ] = t.as_coeffs();
        decompose(scale_x, scale_xy, scale_yx, scale_y, t_x, t_y)
    }
}

#[cfg(feature = "glyphs")]
mod glyphs {
    use super::*;
    use glyphslib::glyphs2;
    impl From<&glyphs2::Transform> for DecomposedAffine {
        fn from(t: &glyphs2::Transform) -> Self {
            decompose(t.m11, t.m12, t.m21, t.m22, t.t_x, t.t_y)
        }
    }
}

#[cfg(feature = "fontra")]
mod fontra {
    use super::*;
    use crate::convertors::fontra::DecomposedTransform as FontraTransform;
    impl From<DecomposedAffine> for FontraTransform {
        fn from(t: DecomposedAffine) -> Self {
            FontraTransform {
                translate_x: t.translation.0 as f32,
                translate_y: t.translation.1 as f32,
                rotation: t.rotation as f32,
                scale_x: t.scale.0 as f32,
                scale_y: t.scale.1 as f32,
                skew_x: 0.0,
                skew_y: 0.0,
                t_center_x: 0.0,
                t_center_y: 0.0,
            }
        }
    }
    impl From<FontraTransform> for DecomposedAffine {
        fn from(t: FontraTransform) -> Self {
            DecomposedAffine {
                translation: (t.translate_x as f64, t.translate_y as f64),
                scale: (t.scale_x as f64, t.scale_y as f64),
                rotation: t.rotation as f64,
            }
        }
    }
}
