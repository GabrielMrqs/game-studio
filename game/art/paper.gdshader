shader_type canvas_item;

uniform bool lit = false;
uniform bool show_form = false;
uniform sampler2D form : filter_linear, repeat_disable;

void fragment() {
	if (show_form) {
		// Match form.svg's viewBox in the 960×500 room before applying the paper finish.
		vec2 form_uv = (UV * vec2(960.0, 500.0) - vec2(461.0, 354.0)) / vec2(108.0, 44.0);
		if (all(greaterThanEqual(form_uv, vec2(0.0))) && all(lessThanEqual(form_uv, vec2(1.0)))) {
			vec4 sheet = texture(form, form_uv);
			COLOR.rgb = mix(COLOR.rgb, sheet.rgb, sheet.a);
		}
	}
	vec2 paper = floor(UV * vec2(960.0, 500.0));
	float grain = fract(52.9829189 * fract(dot(paper, vec2(0.06711056, 0.00583715))));
	vec2 edge = (UV - 0.5) * vec2(1.0, 0.82);
	float vignette = 1.0 - 0.27 * smoothstep(0.3, 0.67, length(edge));
	COLOR.rgb *= vignette * (0.95 + grain * 0.10);
	if (lit) {
		float radius = length((UV - vec2(491.0 / 960.0, 257.0 / 500.0)) * vec2(1.92, 1.0));
		float halo = exp(-radius * 9.0);
		float lamp = 1.0 - smoothstep(0.012, 0.079, radius);
		COLOR.rgb += vec3(0.31, 0.21, 0.081) * halo;
		COLOR.rgb = mix(COLOR.rgb, vec3(1.0, 0.85, 0.53), lamp * 0.92);
	}
}
